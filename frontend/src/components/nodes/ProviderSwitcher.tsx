import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { addKeyLine, routeSwitch } from '../../lib/directRoute';
import { applyFix, applyProviderPick, providerSwitchState, type ProviderRow, type SwitchState } from '../../lib/providerSwitch';
import type { RouteFix } from '../../lib/directRoute';
import type { ProviderSetupTarget } from '../../lib/providerReadiness';
import { useUIStore } from '../../store/uiStore';
import { useSwitchContext } from '../../hooks/useSwitchContext';
import { floatingBottomLimit } from '../../lib/bottomBar';
import { useCanvasLock } from '../../lib/canvasLock';
import '../../styles/provider-switcher.css';

/**
 * The provider switcher of a route-table node (docs/PROVIDER-ROUTES.md,
 * lib/providerSwitch.ts): which provider runs it, Auto or one route, with
 * each route's key state, price at these settings and why it can't take
 * them. Three ways in, one menu:
 *
 * - `inspector`: the Inspector's "Provider" section, the list in place;
 * - `chip`: the card header chip ("Auto · BFL", "fal.ai", "Krea plan"), which
 *   turns accent with a warning glyph when the run can't start;
 * - `pill`: Create Studio's pill.
 *
 * A pick is a person's switch: it writes `_provider` (and `_kreaAuth` on a
 * node with a Krea plan route: lib/providerSwitch.ts billingWrites) and
 * moves any saved value the new route doesn't take to its closest one there, returning one note per change for the card. Nothing
 * else here writes params on its own: keys changing, a shared graph or an
 * import keep every value, and the menu shows the stop with one-click rows
 * instead. A fix row ("Set Safety back to 2", "Clear Seed") is a person's
 * edit of that one setting (applyFix), so the run starts where it is; a
 * switch row moves it to a provider that can take the recipe.
 */

type Params = Record<string, unknown>;
export type PickHandler = (next: Params, notes: string[]) => void;

interface ProviderSwitcherProps {
  definition: ModelNodeDefinition;
  params: Params;
  variant: 'inspector' | 'chip' | 'pill';
  onPick: PickHandler;
  /** Wired input ports and how many edges reach each (runScope.nodeWiredCounts). */
  wired?: ReadonlyMap<string, number>;
}

const NO_WIRES: ReadonlyMap<string, number> = new Map();

export function ProviderSwitcher({ definition, params, variant, onPick, wired = NO_WIRES }: ProviderSwitcherProps) {
  const context = useSwitchContext(wired);
  const state = useMemo(() => providerSwitchState(definition, params, context), [definition, params, context]);
  const pick = useCallback((row: Pick<ProviderRow, 'writes' | 'routeId'>) => {
    const result = applyProviderPick(definition, params, row, context);
    onPick(result.params, result.notes);
  }, [definition, params, context, onPick]);
  const fix = useCallback((choice: RouteFix) => onPick(applyFix(params, choice), []), [params, onPick]);
  if (!routeSwitch(definition)) return null;
  if (variant === 'inspector') {
    return (
      <div className="inspector__section provider-switcher provider-switcher--inspector" data-inspector-provider="true">
        <div className="inspector__label" id={`provider-label-${definition.id}`}>Provider</div>
        <ProviderMenu state={state} labelledBy={`provider-label-${definition.id}`} inline onPick={pick} onFix={fix} />
      </div>
    );
  }
  return <ProviderPopoverTrigger state={state} variant={variant} displayName={definition.displayName} onPick={pick} onFix={fix} />;
}

function openSetup(target: ProviderSetupTarget | undefined) {
  if (target) useUIStore.getState().openProviderSetup(target);
}

/** What the row's "Add key →" adds, as the one line every key prompt says
 * (directRoute.addKeyLine; GM, PR #203 r28 item 3): "Add your Replicate
 * token in Settings.", by the provider the key belongs to when that's
 * another (Idol's row is Speridlabs, its key Hugging Face's token). */
function addKeyLabel(row: ProviderRow): string {
  const key = row.setup?.kind === 'api-key' ? row.setup.key : undefined;
  return (key && addKeyLine([key])) || `Add your ${row.label} key in Settings.`;
}

function keyCell(row: ProviderRow, onSetup: (row: ProviderRow) => void): ReactNode {
  if (row.keyState === 'set') return <span className="provider-switcher__key">Key set</span>;
  if (row.keyState === 'signed-in') return <span className="provider-switcher__key">Signed in</span>;
  if (row.keyState === 'connected') {
    // A Space route's Hugging Face token is set (Idol's): the usual green
    // dot and "Connected" (GM, PR #203 r1 and r4).
    return (
      <span className="provider-switcher__key provider-switcher__key--connected">
        <span className="provider-switcher__dot" aria-hidden="true" />Connected
      </span>
    );
  }
  if (row.keyState === 'missing' || row.keyState === 'sign-in') {
    const text = row.keyState === 'missing' ? 'Add key →' : 'Sign in';
    return (
      <button type="button" role="menuitem" tabIndex={-1} className="provider-switcher__setup"
        // The line every key prompt says (GM, PR #203 r28 item 3):
        // "Add your Hugging Face token in Settings."
        aria-label={row.keyState === 'missing' ? addKeyLabel(row) : 'Sign in to Krea in Settings'}
        onClick={(event) => { event.stopPropagation(); onSetup(row); }}>
        {text}
      </button>
    );
  }
  return <span className="provider-switcher__key" aria-hidden="true" />;
}

interface ProviderMenuProps {
  state: SwitchState;
  onPick: (row: Pick<ProviderRow, 'writes' | 'routeId'>) => void;
  /** A fix row under a stop: reset or clear the one setting that stops it. */
  onFix?: (fix: RouteFix) => void;
  /** Rendered in place (the Inspector) rather than in a popover. */
  inline?: boolean;
  labelledBy?: string;
  label?: string;
  onClose?: (returnFocus: boolean) => void;
}

/** The menu: role=menu with menuitemradio rows, arrow keys, Home/End,
 * Escape and Tab (both close a popover, focus back on its trigger). In a popover the checked row takes focus when it opens; in place,
 * one row is in the tab order (roving tabindex). */
export function ProviderMenu({ state, onPick, onFix, inline = false, labelledBy, label, onClose }: ProviderMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Fix round 2 of PR #200 (review 2 L-5): a pick writes the node's params
  // (updateNodeData, which the store refuses while following or offline), so
  // every provider, fix and switch row takes the canvas lock: disabled,
  // marked, the reason as its tooltip. The key cell only opens Settings.
  const lock = useCanvasLock();
  const checkedIndex = Math.max(0, state.rows.findIndex((row) => row.selected));
  // The row in the tab order when the menu is in place: the last one
  // focused, else the checked one.
  const [focused, setActive] = useState<number | null>(null);
  const active = focused !== null && focused < state.rows.length ? focused : checkedIndex;

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];

  useLayoutEffect(() => {
    if (inline) return;
    const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
      ?? items()[0];
    checked?.focus({ preventScroll: true });
  }, [inline]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      const next = list[(to + list.length) % list.length];
      next?.focus();
      const row = next?.closest<HTMLElement>('[data-provider-row]');
      if (row) setActive(Number(row.dataset.providerRow));
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at < 0 ? list.length - 1 : at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape' && onClose) onClose(true);
    // The popover is portalled to the end of the body, so the browser's own
    // Tab would leave the canvas: close and put focus back on the trigger.
    else if (event.key === 'Tab' && onClose) onClose(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const setup = (row: ProviderRow) => {
    onClose?.(false);
    openSetup(row.setup);
  };

  return (
    <>
    <div ref={menuRef} role="menu" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : (label ?? 'Provider')}
      className={`provider-switcher__menu${inline ? ' provider-switcher__menu--inline' : ''}`}
      onKeyDown={onKeyDown} onMouseDown={(event) => event.stopPropagation()}>
      {state.rows.map((row, index) => (
        <div key={row.id} role="none" data-provider-row={index}
          className={`provider-switcher__row${row.selected ? ' provider-switcher__row--selected' : ''}${row.block ? ' provider-switcher__row--blocked' : ''}${row.routeId === null ? ' provider-switcher__row--auto' : ''}${row.info ? ' provider-switcher__row--info' : ''}`}>
          <button type="button" role="menuitemradio" aria-checked={row.selected}
            tabIndex={inline && index === active ? 0 : -1}
            className="provider-switcher__item"
            {...lock.act({ title: row.block ?? row.info, offline: true })}
            onClick={() => { onPick(row); onClose?.(true); }}>
            <span className="provider-switcher__check" aria-hidden="true">
              {row.selected && <Check size={12} strokeWidth={2} />}
            </span>
            <span className="provider-switcher__name">
              <span className="provider-switcher__label">{row.label}</span>
              {row.block && <span className="provider-switcher__block">{row.block}</span>}
            </span>
            <span className="provider-switcher__price" title={row.priceTitle}>{row.price}</span>
            {row.info && <span className="provider-switcher__info">{row.info}</span>}
          </button>
          {row.routeId !== null && keyCell(row, setup)}
        </div>
      ))}
      {state.blocked && ((onFix && state.fixes.length > 0) || state.alternatives.length > 0) && (
        <div role="none" className="provider-switcher__actions">
          {onFix && state.fixes.length > 0 && (
            <div role="group" aria-label="Settings that let it run here" className="provider-switcher__alternatives">
              {state.fixes.map((choice) => (
                <button key={choice.param} type="button" role="menuitem" tabIndex={-1}
                  className="provider-switcher__alternative provider-switcher__fix"
                  {...lock.act({ offline: true })}
                  onClick={() => {
                    onFix(choice);
                    onClose?.(true);
                  }}>
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {state.alternatives.length > 0 && (
            <div role="group" aria-label="Providers that can run it" className="provider-switcher__alternatives">
              {state.alternatives.map((alternative) => (
                <button key={alternative.routeId} type="button" role="menuitem" tabIndex={-1}
                  className="provider-switcher__alternative"
                  {...lock.act({ offline: true })}
                  onClick={() => {
                    onPick({ writes: alternative.writes, routeId: alternative.routeId });
                    onClose?.(true);
                  }}>
                  Switch to {alternative.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
    {state.blocked && state.message && (
      <div role="status" className="provider-switcher__stop">{state.message}</div>
    )}
    </>
  );
}

function ProviderPopoverTrigger({ state, variant, displayName, onPick, onFix }: {
  state: SwitchState;
  variant: 'chip' | 'pill';
  displayName: string;
  onPick: (row: Pick<ProviderRow, 'writes' | 'routeId'>) => void;
  onFix: (fix: RouteFix) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const className = variant === 'chip'
    ? `model-node__provider-chip nodrag nopan${state.blocked ? ' model-node__provider-chip--blocked' : ''}`
    : `param-pill provider-switcher__pill${state.blocked ? ' provider-switcher__pill--blocked' : ''}`;
  return (
    <>
      <button ref={triggerRef} type="button" className={className}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        // Blocked, the name ends with the reason itself, never a "Can't run"
        // prefix (GM, PR #203 r6 item 2): each reason is a whole sentence.
        aria-label={`Provider for ${displayName}: ${state.chipName}${state.blocked && state.message ? `. ${state.message}` : ''}`}
        title={state.blocked ? state.message ?? undefined : `Runs on ${state.chipName}. Change provider`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); }
        }}>
        {state.blocked && <span className="provider-switcher__warning" aria-hidden="true">&#x26A0;</span>}
        {variant === 'pill' && <span className="param-pill__label">Provider</span>}
        {/* The card chip has room for a short name only where the full one
            can't fit (chipText); Create Studio's pill wraps, so it names it in full. */}
        <span className="provider-switcher__chip-text">{variant === 'pill' ? state.chipName : state.chip}</span>
        {variant === 'pill' && <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      {open && (
        <ProviderPopover anchorRef={triggerRef} id={menuId} onClose={close}>
          <ProviderMenu state={state} onPick={onPick} onFix={onFix} label={`Provider for ${displayName}`} onClose={close} />
        </ProviderPopover>
      )}
    </>
  );
}

/** The menu over the canvas: fixed under its trigger (above it when there's
 * no room below), opening on a spring (provider-switcher.css). A press or
 * wheel outside closes it; Escape closes it and returns focus. */
function ProviderPopover({ anchorRef, id, onClose, children }: {
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  onClose: (returnFocus: boolean) => void;
  children: ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const popover = popoverRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = popover?.width ?? 300;
    const height = popover?.height ?? 0;
    const gap = 6;
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - width - 8));
    // Under the chip unless that crosses the window's bottom or the canvas's
    // bottom bar, or the Canvas actions panel where it is over it (lib/bottomBar.ts).
    const bottom = floatingBottomLimit(8, window.innerHeight, { left, right: left + width });
    const above = anchor.bottom + gap + height > bottom && anchor.top - gap - height > 8;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement: the popover's place depends on its own rendered size
    setPosition({ left, top: above ? anchor.top - gap - height : anchor.bottom + gap, above });
  }, [anchorRef]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (popoverRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onClose(false);
    };
    const resize = () => onClose(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', outside, { capture: true, passive: true });
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', outside, true);
      window.removeEventListener('resize', resize);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div ref={popoverRef} id={id}
      // nokey: portalled from inside the node card, its keys bubble (React) to
      // React Flow's node, which would move or select it (review 9, M-1).
      className={`provider-switcher__popover nokey${position ? ' provider-switcher__popover--open' : ''}${position?.above ? ' provider-switcher__popover--above' : ''}`}
      style={position ? { left: position.left, top: position.top } : undefined}
      onClick={(event) => event.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

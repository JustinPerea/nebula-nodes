import { Children, type ReactNode, type Ref } from 'react';
import type { RowTone } from './rowHelpers';

/**
 * One provider line: status dot, name, a one-line summary, a trailing action,
 * and an optional body that opens in place underneath.
 */
export function ProviderRow({ id, tone, name, status, statusTone, summary, title, action, children, setup, rowRef }: {
  id: string;
  tone: RowTone;
  name: string;
  /** A short state word ("Connected", "Key rejected") shown before the summary. */
  status?: string;
  statusTone?: 'ok' | 'warn';
  summary?: string;
  /** Longer explanation of the status, on hover. */
  title?: string;
  action: ReactNode;
  children?: ReactNode;
  /** Marks rows a setup link can jump to (Krea sign-in, Nous). */
  setup?: string;
  rowRef?: Ref<HTMLDivElement>;
}) {
  // Rows pass conditional bodies (`open && …`), so count what actually renders.
  const hasBody = Children.toArray(children).length > 0;
  return (
    <div ref={rowRef} className={`settings-row${hasBody ? ' settings-row--open' : ''}`} data-row={id}
      {...(setup ? { 'data-provider-setup': setup, tabIndex: -1 } : {})}>
      <span className={`settings-row__dot settings-row__dot--${tone}`} aria-hidden="true" />
      <div className="settings-row__text" title={title}>
        <div className="settings-row__name">{name}</div>
        {(status || summary) && (
          <div className="settings-row__summary">
            {status && <span className={statusTone ? `settings-row__status--${statusTone}` : undefined}>{status}</span>}
            {status && summary && ' · '}
            {summary}
          </div>
        )}
      </div>
      <div className="settings-row__action">{action}</div>
      {hasBody && <div className="settings-row__body">{children}</div>}
    </div>
  );
}

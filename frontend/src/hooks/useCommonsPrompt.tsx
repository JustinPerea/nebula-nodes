import { useCallback, useState, type ReactNode } from 'react';
import { PromptDialog, type PromptRequest } from '../components/commons/CommonsPrompt';

/**
 * An in-view replacement for window.prompt, which the Electron shell doesn't implement.
 * `ask` resolves to the entered text, or null when cancelled.
 */
export function useCommonsPrompt(): [(label: string, initial?: string) => Promise<string | null>, ReactNode] {
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const ask = useCallback(
    (label: string, initial = '') =>
      new Promise<string | null>((resolve) => setRequest({ label, initial, resolve })),
    [],
  );
  const element = request ? (
    <PromptDialog
      request={request}
      onDone={(value) => {
        request.resolve(value);
        setRequest(null);
      }}
    />
  ) : null;
  return [ask, element];
}

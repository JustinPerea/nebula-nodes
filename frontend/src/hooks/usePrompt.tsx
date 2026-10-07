import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PromptDialog, type PromptRequest } from '../components/PromptDialog';

/** Resolves text entry, or null on cancellation, replacement, or unmount. */
export function usePrompt(): [(label: string, initial?: string) => Promise<string | null>, ReactNode] {
  const [request, setRequest] = useState<(PromptRequest & { id: number }) | null>(null);
  const pending = useRef<PromptRequest | null>(null);
  const sequence = useRef(0);
  const ask = useCallback((label: string, initial = '') => new Promise<string | null>((resolve) => {
    pending.current?.resolve(null);
    const next = { label, initial, resolve, id: sequence.current++ };
    pending.current = next;
    setRequest(next);
  }), []);
  const finish = useCallback((value: string | null) => {
    pending.current?.resolve(value);
    pending.current = null;
    setRequest(null);
  }, []);
  useEffect(() => () => {
    pending.current?.resolve(null);
    pending.current = null;
  }, []);
  return [ask, request ? <PromptDialog key={request.id} request={request} onDone={finish} /> : null];
}

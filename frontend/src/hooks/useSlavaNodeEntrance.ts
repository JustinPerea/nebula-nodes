import { useEffect, useState } from 'react';
import { useUIStore } from '../store/uiStore';

const SLAVA_NODE_ENTER_MS = 220;

export function useSlavaNodeEntranceClass(): string {
  const [entering, setEntering] = useState(() => (
    useUIStore.getState().skin === 'slava-restraint'
  ));

  useEffect(() => {
    if (!entering) return undefined;
    const timeout = window.setTimeout(() => setEntering(false), SLAVA_NODE_ENTER_MS + 40);
    return () => window.clearTimeout(timeout);
  }, [entering]);

  return entering ? ' model-node--entering' : '';
}
